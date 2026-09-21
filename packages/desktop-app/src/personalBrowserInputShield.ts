import type {
  Event as ElectronEvent,
  Input,
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
      body { cursor: not-allowed; overflow: hidden; user-select: none; }
      .status {
        position: fixed;
        top: 10px;
        right: 10px;
        padding: 6px 9px;
        border: 1px solid rgba(255, 255, 255, 0.24);
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.88);
        color: white;
        font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.2);
      }
    </style>
  </head>
  <body><div class="status">Browser controlled · Esc to take back</div></body>
</html>`;

const SHIELD_URL = `data:text/html;charset=utf-8,${encodeURIComponent(SHIELD_HTML)}`;

type PersonalBrowserInputShieldOptions = {
  createView: () => WebContentsView;
  onEmergencyEscape: () => void;
};

export class PersonalBrowserInputShield {
  private readonly createView: PersonalBrowserInputShieldOptions["createView"];
  private readonly onEmergencyEscape: PersonalBrowserInputShieldOptions["onEmergencyEscape"];
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
  private bounds: Rectangle = { x: 0, y: 0, width: 1, height: 1 };
  private emergencyEscapeQueued = false;

  constructor(options: PersonalBrowserInputShieldOptions) {
    this.createView = options.createView;
    this.onEmergencyEscape = options.onEmergencyEscape;
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

  sync(active: boolean, visible: boolean, bounds: Rectangle) {
    this.active = active;
    this.visible = visible;
    this.bounds = bounds;
    this.syncView();
  }

  destroy() {
    this.active = false;
    this.visible = false;
    this.protectedContents?.removeListener("before-input-event", this.handleProtectedInput);
    this.protectedContents = null;
    const view = this.shieldView;
    this.shieldView = null;
    if (!view) {
      this.owner = null;
      return;
    }
    this.owner?.removeChildView(view);
    view.webContents.removeListener("before-input-event", this.handleBeforeInput);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false });
    }
    this.owner = null;
  }

  private readonly handleBeforeInput = (event: ElectronEvent, input: Input) => {
    if (!this.active) {
      return;
    }
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
    view.webContents.on("before-input-event", this.handleBeforeInput);
    view.webContents.on("context-menu", (event) => event.preventDefault());
    void view.webContents.loadURL(SHIELD_URL).catch(() => undefined);
    this.shieldView = view;
    return view;
  }

  private syncView() {
    if (!this.active) {
      if (this.shieldView) {
        this.shieldView.setVisible(false);
      }
      if (this.visible && this.protectedContents && !this.protectedContents.isDestroyed()) {
        this.protectedContents.focus();
      }
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
    if (this.visible && !view.webContents.isDestroyed()) {
      view.webContents.focus();
    }
  }
}
