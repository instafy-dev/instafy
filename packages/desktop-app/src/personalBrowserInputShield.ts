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
      /* Match RemoteControlSurface's edge glow in this isolated native document. */
      .glow {
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 1;
        /* Light gathers at the rim and dissolves before it reaches the page content. */
        mask-image: linear-gradient(to right, #000, #0009 3px, #0003 9px, transparent 20px, transparent calc(100% - 20px), #0003 calc(100% - 9px), #0009 calc(100% - 3px), #000), linear-gradient(to bottom, #000, #0009 3px, #0003 9px, transparent 20px, transparent calc(100% - 20px), #0003 calc(100% - 9px), #0009 calc(100% - 3px), #000);
        mask-composite: add;
        box-shadow: inset 0 0 0 1px #bac7e514;
        animation: browser-control-arrive 1600ms ease-out;
      }

      .glow::before,
      .glow::after {
        content: "";
        position: absolute;
        inset: -25%;
        opacity: 0.75;
        /* Soft, overlapping lobes provide texture without a repeating pattern. */
        background:
          radial-gradient(ellipse 28% 46% at 24% 18%, #e3eafab3, #b5c5ee59 34%, transparent 72%),
          radial-gradient(ellipse 32% 38% at 76% 78%, #dcdff59e, #b9b6e540 38%, transparent 74%),
          radial-gradient(ellipse 22% 34% at 88% 28%, #b4c5ed66, transparent 74%);
        animation: agent-edge-flow 23s ease-in-out infinite alternate paused;
      }

      .glow::after {
        background:
          radial-gradient(ellipse 26% 42% at 68% 22%, #e8edf599, #c4bdea40 38%, transparent 73%),
          radial-gradient(ellipse 30% 36% at 22% 74%, #c3d1eb80, #a9bce833 42%, transparent 75%);
        animation-duration: 37s;
        animation-direction: alternate-reverse;
      }

      body[data-working="true"] .glow::before, body[data-working="true"] .glow::after { animation-play-state: running; will-change: transform; }
      .status {
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        padding: 8px 14px; border: 1px solid #ffffff26; border-radius: 999px;
        background: #0f172ae6; color: white;
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap; opacity: 0; pointer-events: none;
      }
      body:focus-visible .status { opacity: 1; }
      @keyframes agent-edge-flow {
        0% { transform: translate3d(-6%, -4%, 0) rotate(-4deg) scale(1.04); }
        43% { transform: translate3d(3%, 5%, 0) rotate(2deg) scale(1.12); }
        100% { transform: translate3d(7%, -2%, 0) rotate(5deg) scale(1); }
      }

      @keyframes browser-control-arrive {
        0% { opacity: 0; filter: brightness(1); }
        30% { opacity: 1; filter: brightness(1.35); }
        100% { opacity: 1; filter: brightness(1); }
      }

      @media (prefers-reduced-motion: reduce) { .glow { animation: none; } .glow::before, .glow::after { animation: none; transform: none; will-change: auto !important; } }
    </style>
  </head>
  <body role="button" tabindex="0" aria-label="AI has browser control. Click to take over, or press Escape to pause."><div class="glow" aria-hidden="true"></div><div class="status">Click to take over · Esc to pause</div></body>
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
  private bloomPending = false;
  private controller: "agent" | "participant" = "agent";
  private loaded = false;
  private appliedAppearance: string | null = null;
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

  sync(active: boolean, visible: boolean, bounds: Rectangle, working = false, controller: "agent" | "participant" = "agent") {
    if (active && (!this.active || controller !== this.controller)) this.bloomPending = true;
    if (!active) this.bloomPending = false;
    this.active = active;
    this.visible = visible;
    this.bounds = bounds;
    this.working = active && visible && working;
    this.controller = controller;
    this.syncActivity();
    this.syncView();
  }

  destroy() {
    this.active = false;
    this.bloomPending = false;
    this.visible = false;
    this.showing = false;
    this.protectedContents?.removeListener("before-input-event", this.handleProtectedInput);
    this.protectedContents = null;
    const view = this.shieldView;
    this.shieldView = null;
    this.loaded = false;
    this.appliedAppearance = null;
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
    const appearance = `${this.working}:${this.controller}`;
    const bloom = this.bloomPending && this.visible;
    if (!this.loaded || !view || view.webContents.isDestroyed() || (this.appliedAppearance === appearance && !bloom)) return;
    if (bloom) this.bloomPending = false;
    this.appliedAppearance = appearance;
    const participant = this.controller === "participant";
    const label = participant ? "Another participant has control. Click to take back, or press Escape." : "AI has browser control. Click to take over, or press Escape to pause.";
    const hint = participant ? "Click to take back control · Esc to take back" : "Click to take over · Esc to pause";
    // Only our isolated shield document receives these fixed UI strings.
    void view.webContents.executeJavaScript(`document.body.dataset.working = "${this.working}";
      document.body.setAttribute("aria-label", ${JSON.stringify(label)});
      document.querySelector(".status").textContent = ${JSON.stringify(hint)};
      if (${bloom}) {
        const glow = document.querySelector(".glow");
        glow.replaceWith(glow.cloneNode(true));
      }`).catch(() => undefined);
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
